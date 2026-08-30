import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import type { AvailablePlugin, Marketplace, MarketplaceManifestMap, MutationResult, Plugin, PluginError, PluginScope, PluginValidateResult } from '../../../shared/plugins'
import { isPluginError } from '../../../shared/plugins'

type LoadingState = 'idle' | 'loading' | 'success' | 'error'

type PluginsState = {
  installed: Plugin[]
  available: AvailablePlugin[]
  marketplaces: Marketplace[]
  // Rich per-plugin metadata from marketplace manifests (category, author,
  // homepage). Fetched in parallel with pluginList/marketplaceList so the
  // catalog can group by category without a second round-trip.
  manifests: MarketplaceManifestMap
  loading: LoadingState
  availableLoading: boolean
  error?: PluginError
  availableError?: PluginError
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

export function usePlugins() {
  const [state, setState] = useState<PluginsState>({
    installed: [],
    available: [],
    marketplaces: [],
    loading: 'idle',
    availableLoading: false,
    pendingRestartPluginIds: loadPendingRestart(),
    availableError: undefined,
    manifests: {},
  })
  // Track in-flight mutations so the UI can show per-card spinners and avoid
  // double-dispatch on rapid clicks.
  const mutatingIds = useRef<Set<string>>(new Set())

  // refreshAll: plugin_list + marketplace_list in parallel, then plugin_available
  // (slower — 30s). Skeletons show while available loads.
  const refreshAll = useCallback(async () => {
    setState(prev => ({ ...prev, loading: 'loading', error: undefined }))
    try {
      const [installed, marketplaces, manifests] = await Promise.all([
        window.verboo.pluginList(),
        window.verboo.marketplaceList(),
        window.verboo.marketplaceManifests().catch(() => ({})),
      ])
      setState(prev => ({ ...prev, installed, marketplaces, manifests, loading: 'success' }))
      // plugin_available is slow — kick it off after the fast reads resolve
      // so the Installed section renders immediately.
      setState(prev => ({ ...prev, availableLoading: true, availableError: undefined }))
      try {
        const payload = await window.verboo.pluginAvailable()
        setState(prev => ({ ...prev, available: payload.available, availableLoading: false }))
      } catch (err) {
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

  // Cross-window plugin-mutation listener (Feedback-6 OBJ 1):
  // When another window (or the backend itself) mutates plugins, the
  // `plugin-mutation` Tauri event fires. We re-fetch so this hook's state
  // stays in sync without the caller needing to wire anything up.
  useEffect(() => {
    let unlistenFn: (() => void) | undefined
    const unlistenPromise = listen('plugin-mutation', () => {
      void refreshAll()
    })
    unlistenPromise.then(fn => { unlistenFn = fn }).catch(() => {})
    return () => {
      unlistenFn?.()
      // If the listener setup hasn't resolved yet, the then() above hasn't
      // run — the cleanup runs synchronously, so we also drain the promise
      // to avoid a dangling listener attaching after unmount.
      unlistenPromise.then(fn => fn()).catch(() => {})
    }
  }, [refreshAll])

  const install = useCallback(async (plugin: AvailablePlugin, scope: PluginScope) => {
    if (mutatingIds.current.has(plugin.pluginId)) return
    mutatingIds.current.add(plugin.pluginId)
    // Optimistic: build minimal installed Plugin entry from AvailablePlugin
    // data so the list shows the plugin as installed immediately. refreshAll
    // reconciles in background; a failure reverts via catch.
    const optimisticPlugin: Plugin = {
      id: plugin.pluginId,
      name: plugin.name,
      version: 'latest',
      scope,
      enabled: true,
      installed: true,
      installPath: '',
      installedAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      description: plugin.description,
    }
    setState(prev => ({ ...prev, installed: [...prev.installed, optimisticPlugin] }))
    try {
      const result = await window.verboo.pluginInstall(plugin.pluginId, scope) as MutationResult
      if (!result.success) {
        throw result.error ?? { kind: 'unknown', message: 'Install failed', } as PluginError
      }
      void refreshAll()
      return true
    } catch (err) {
      // Revert optimistic (fires for IPC rejection OR success:false).
      setState(prev => ({ ...prev, installed: prev.installed.filter(p => p.id !== plugin.pluginId) }))
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    } finally {
      mutatingIds.current.delete(plugin.pluginId)
    }
  }, [refreshAll])

  const enable = useCallback(async (id: string, scope: PluginScope) => {
    setState(prev => ({
      ...prev,
      installed: prev.installed.map(p => p.id === id ? { ...p, enabled: true } : p),
    }))
    try {
      await window.verboo.pluginEnable(id, scope)
    } catch (err) {
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
    setState(prev => ({ ...prev, installed: prev.installed.filter(p => p.id !== id) }))
    try {
      const result = await window.verboo.pluginUninstall(id, scope, keepData) as MutationResult
      if (!result.success) {
        // Revert: put back the plugin that was optimistically removed.
        // The caller (PluginsView) will show the typed error toast.
        void refreshAll()
        throw result.error ?? { kind: 'unknown', message: 'Uninstall failed' } as PluginError
      }
      void refreshAll()
      return true
    } catch (err) {
      if (!isPluginError(err)) void refreshAll()
      throw isPluginError(err) ? err : { kind: 'unknown', message: String(err) } as PluginError
    } finally {
      mutatingIds.current.delete(id)
    }
  }, [refreshAll])

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
