import { useCallback, useEffect, useRef, useState } from 'react'
import type { AvailablePlugin, Marketplace, Plugin, PluginError, PluginScope, PluginValidateResult } from '../../../shared/plugins'
import { isPluginError } from '../../../shared/plugins'

// ── State shape ──────────────────────────────────────────────────────
type LoadingState = 'idle' | 'loading' | 'success' | 'error'

type PluginsState = {
  installed: Plugin[]
  available: AvailablePlugin[]
  marketplaces: Marketplace[]
  loading: LoadingState
  availableLoading: boolean
  error?: PluginError
  // Separate error for the available-catalog fetch. Non-fatal: if installed
  // plugins loaded fine, we show this only in the Featured section empty
  // state (with a retry) rather than a full-page error banner.
  availableError?: PluginError
  // Plugin ids that were updated and need an app restart to take effect.
  // Persisted to localStorage so the banner survives reloads.
  pendingRestartPluginIds: Set<string>
}

const RESTART_STORAGE_KEY = 'verboo:plugins:pending-restart'

function loadPendingRestart(): Set<string> {
  try {
    const raw = localStorage.getItem(RESTART_STORAGE_KEY)
    if (!raw) return new Set()
    const ids = JSON.parse(raw) as string[]
    return new Set(ids)
  } catch {
    return new Set()
  }
}

function savePendingRestart(ids: Set<string>) {
  try {
    localStorage.setItem(RESTART_STORAGE_KEY, JSON.stringify([...ids]))
  } catch {
    // localStorage may be unavailable (private mode) — non-fatal, the banner
    // just won't persist across reloads.
  }
}

// ── Hook ──────────────────────────────────────────────────────────────
export function usePlugins() {
  const [state, setState] = useState<PluginsState>({
    installed: [],
    available: [],
    marketplaces: [],
    loading: 'idle',
    availableLoading: false,
    pendingRestartPluginIds: loadPendingRestart(),
    availableError: undefined,
  })
  // Track in-flight mutations so the UI can show per-card spinners and avoid
  // double-dispatch on rapid clicks.
  const mutatingIds = useRef<Set<string>>(new Set())

  // refreshAll: plugin_list + marketplace_list in parallel, then plugin_available
  // (slower — 30s). Skeletons show while available loads.
  const refreshAll = useCallback(async () => {
    setState(prev => ({ ...prev, loading: 'loading', error: undefined }))
    try {
      const [installed, marketplaces] = await Promise.all([
        window.verboo.pluginList(),
        window.verboo.marketplaceList(),
      ])
      setState(prev => ({ ...prev, installed, marketplaces, loading: 'success' }))
      // plugin_available is slow — kick it off after the fast reads resolve
      // so the Installed section renders immediately.
      setState(prev => ({ ...prev, availableLoading: true, availableError: undefined }))
      try {
        const payload = await window.verboo.pluginAvailable()
        setState(prev => ({ ...prev, available: payload.available, availableLoading: false }))
      } catch (err) {
        // available failing is non-fatal — Installed section still works.
        // Store as availableError so the Featured section can show a scoped
        // empty state + retry, rather than a full-page error banner that
        // would hide the already-loaded Installed plugins.
        const pluginErr = isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
        setState(prev => ({ ...prev, availableLoading: false, availableError: pluginErr }))
      }
    } catch (err) {
      setState(prev => ({ ...prev, loading: 'error', error: isPluginError(err) ? err : { kind: 'unknown', message: String(err) } }))
    }
  }, [])

  useEffect(() => {
    void refreshAll()
  }, [refreshAll])

  // ── Mutations ──────────────────────────────────────────────────────
  const install = useCallback(async (plugin: AvailablePlugin, scope: PluginScope) => {
    if (mutatingIds.current.has(plugin.pluginId)) return
    mutatingIds.current.add(plugin.pluginId)
    try {
      await window.verboo.pluginInstall(plugin.pluginId, scope)
      // Re-fetch list to get the new installed row + merge.
      const installed = await window.verboo.pluginList()
      setState(prev => ({ ...prev, installed }))
      return true
    } catch (err) {
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    } finally {
      mutatingIds.current.delete(plugin.pluginId)
    }
  }, [])

  const enable = useCallback(async (id: string, scope: PluginScope) => {
    // Optimistic: flip enabled immediately, revert on error.
    setState(prev => ({
      ...prev,
      installed: prev.installed.map(p => p.id === id ? { ...p, enabled: true } : p),
    }))
    try {
      await window.verboo.pluginEnable(id, scope)
    } catch (err) {
      // Revert
      setState(prev => ({
        ...prev,
        installed: prev.installed.map(p => p.id === id ? { ...p, enabled: false } : p),
      }))
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    }
  }, [])

  const disable = useCallback(async (id: string, scope: PluginScope) => {
    setState(prev => ({
      ...prev,
      installed: prev.installed.map(p => p.id === id ? { ...p, enabled: false } : p),
    }))
    try {
      await window.verboo.pluginDisable(id, scope)
    } catch (err) {
      setState(prev => ({
        ...prev,
        installed: prev.installed.map(p => p.id === id ? { ...p, enabled: true } : p),
      }))
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    }
  }, [])

  const uninstall = useCallback(async (id: string, scope: PluginScope, keepData = false) => {
    if (mutatingIds.current.has(id)) return
    mutatingIds.current.add(id)
    try {
      await window.verboo.pluginUninstall(id, scope, keepData)
      const installed = await window.verboo.pluginList()
      setState(prev => ({ ...prev, installed }))
      return true
    } catch (err) {
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    } finally {
      mutatingIds.current.delete(id)
    }
  }, [])

  const update = useCallback(async (id: string, scope: PluginScope) => {
    if (mutatingIds.current.has(id)) return
    mutatingIds.current.add(id)
    try {
      await window.verboo.pluginUpdate(id, scope)
      const installed = await window.verboo.pluginList()
      setState(prev => {
        const next = new Set(prev.pendingRestartPluginIds)
        next.add(id)
        savePendingRestart(next)
        return { ...prev, installed, pendingRestartPluginIds: next }
      })
      return true
    } catch (err) {
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    } finally {
      mutatingIds.current.delete(id)
    }
  }, [])

  const validate = useCallback(async (path: string): Promise<PluginValidateResult> => {
    return await window.verboo.pluginValidate(path)
  }, [])

  const addMarketplace = useCallback(async (source: string, scope?: string) => {
    await window.verboo.marketplaceAdd(source, scope)
    const marketplaces = await window.verboo.marketplaceList()
    // Re-fetch available too — the new marketplace may add plugins.
    try {
      const payload = await window.verboo.pluginAvailable()
      setState(prev => ({ ...prev, marketplaces, available: payload.available }))
    } catch {
      setState(prev => ({ ...prev, marketplaces }))
    }
  }, [])

  const removeMarketplace = useCallback(async (name: string) => {
    await window.verboo.marketplaceRemove(name)
    const [marketplaces, installed] = await Promise.all([
      window.verboo.marketplaceList(),
      window.verboo.pluginList(),
    ])
    setState(prev => ({ ...prev, marketplaces, installed }))
    // Re-fetch available — removed marketplace's plugins should disappear.
    try {
      const payload = await window.verboo.pluginAvailable()
      setState(prev => ({ ...prev, available: payload.available }))
    } catch {
      // non-fatal
    }
  }, [])

  const dismissRestartBanner = useCallback(() => {
    setState(prev => {
      const next = new Set<string>()
      savePendingRestart(next)
      return { ...prev, pendingRestartPluginIds: next }
    })
  }, [])

  return {
    ...state,
    refreshAll,
    install,
    enable,
    disable,
    uninstall,
    update,
    validate,
    addMarketplace,
    removeMarketplace,
    dismissRestartBanner,
  }
}
