import { useEffect, useState } from 'react'

// ── In-memory session cache ──────────────────────────────────────────
// Avoids re-fetching the same icon when the component re-mounts or the
// list re-renders. Cleared on full page reload (session scope is enough —
// icons don't change within a session, and the backend caches on disk).
//
// Cache values:
// - string  → resolved icon URL (convertFileSrc'd path)
// - null    → backend responded with None (definitive: no homepage / fetch
//             failed / loadWebIcons off). Cached so we don't re-fetch.
// - ABSENT  → never fetched (not in Map). Hook will fetch when enabled.
//
// The critical distinction: we only cache `null` when the backend ACTUALLY
// responded. If the hook didn't fire (enabled was false, or data wasn't
// ready), we don't cache anything — so a later render with enabled=true
// will fetch fresh. This prevents the "null-forever" bug where a transient
// state (loadIcons undefined, manifests not loaded) poisoned the cache.
const iconCache = new Map<string, string | null>()

// Invalidate the cache for a plugin (or all). Called when the manifests
// arrive — a plugin that returned null (no homepage) earlier may now have
// a homepage in the freshly-loaded manifest, so we clear the cached null
// and let the next render re-fetch.
export function invalidatePluginIconCache(pluginId?: string) {
  if (pluginId) {
    iconCache.delete(pluginId)
  } else {
    iconCache.clear()
  }
}

type UsePluginIconResult = {
  /** Resolved icon URL (convertFileSrc'd path), or null if unavailable. */
  iconUrl: string | null
  /** True while the icon is being fetched (monogram shows during this). */
  loading: boolean
}

// usePluginIcon — fetches a plugin's icon path from the backend and converts
// it to a displayable URL. Returns null when unavailable (FE renders monogram).
//
// Flow:
// 1. If !enabled → return null, don't fetch, don't cache (not-ready, not
//    definitive). When enabled flips true, the effect re-runs and fetches.
// 2. Check session cache → if hit (string or null), return immediately.
// 3. Call window.verboo.pluginIcon(pluginId) → returns { iconPath, ... }
// 4. If iconPath is a string → convertFileSrc, cache URL, return URL.
// 5. If iconPath is null → cache null (definitive), return null.
// 6. On error → cache null (definitive), return null.
//
// The effect depends on [pluginId, enabled] so it re-fires when enabled
// transitions false→true. This is the fix for the "lines that never called
// plugin_icon" bug: if the first render had enabled=false (or the component
// mounted before data was ready), the cache wasn't poisoned, and the next
// render with enabled=true triggers the fetch.
export function usePluginIcon(pluginId: string, enabled: boolean): UsePluginIconResult {
  const [iconUrl, setIconUrl] = useState<string | null>(() => {
    if (!enabled) return null
    return iconCache.get(pluginId) ?? null
  })
  const [loading, setLoading] = useState<boolean>(() => {
    if (!enabled) return false
    return !iconCache.has(pluginId)
  })

  useEffect(() => {
    if (!enabled) {
      // Not enabled — don't fetch, don't cache. If enabled flips true later,
      // this effect re-runs (enabled is in the dep array) and fetches.
      setIconUrl(null)
      setLoading(false)
      return
    }

    // Cache hit — no fetch needed. This is only reached when the backend
    // previously responded (string or null). A not-ready state never
    // cached, so it won't short-circuit here.
    if (iconCache.has(pluginId)) {
      setIconUrl(iconCache.get(pluginId) ?? null)
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)

    window.verboo.pluginIcon(pluginId).then(result => {
      if (cancelled) return
      const path = result?.iconPath
      if (path) {
        const url = window.verboo.fileUrl(path)
        iconCache.set(pluginId, url)
        setIconUrl(url)
      } else {
        // null = backend responded with None (definitive). Cache it so we
        // don't re-fetch. Diagnostic log helps distinguish "no homepage"
        // from "loadWebIcons off" from a silent FE bug.
        console.warn('[usePluginIcon] null iconPath for', pluginId, '— result:', result)
        iconCache.set(pluginId, null)
        setIconUrl(null)
      }
    }).catch(err => {
      if (cancelled) return
      // Error → definitive null (monogram forever, no retry loop).
      // Diagnostic: log the real error so we can see if the invoke name is
      // wrong, the backend panicked, or the settings_store gate blocked it.
      console.error('[usePluginIcon] fetch failed for', pluginId, '—', err)
      iconCache.set(pluginId, null)
      setIconUrl(null)
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })

    return () => { cancelled = true }
  }, [pluginId, enabled])

  return { iconUrl, loading }
}
