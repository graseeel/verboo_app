import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { ThemeMode } from '../../../shared/types'

const THEME_KEY = 'verboo:theme'

/**
 * Resolve a ThemeMode to a concrete `dark` or `light`. `system` defers
 * to the OS preference via matchMedia; falls back to `dark` when
 * matchMedia is unavailable (SSR, very old browsers).
 */
function resolveTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'dark' || mode === 'light') return mode
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function readTheme(): ThemeMode {
  const stored = window.localStorage.getItem(THEME_KEY)
  if (stored === 'dark' || stored === 'light' || stored === 'system') return stored
  return 'system'
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeMode>(readTheme)
  const [resolved, setResolved] = useState<'dark' | 'light'>(() => resolveTheme(readTheme()))

  // Apply the resolved theme to the DOM + persist the preference.
  useEffect(() => {
    document.documentElement.dataset.theme = resolved
  }, [resolved])

  useEffect(() => {
    window.localStorage.setItem(THEME_KEY, theme)
    setResolved(resolveTheme(theme))
  }, [theme])

  // When in `system` mode, listen for OS preference changes and update
  // the resolved theme without touching the stored preference.
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = (e: MediaQueryListEvent) => {
      setResolved(e.matches ? 'dark' : 'light')
    }
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [theme])

  function setTheme(next: ThemeMode) {
    setThemeState(next)
  }

  /** Cycle dark → light → system → dark. Used by the command palette toggle. */
  function cycleTheme() {
    setThemeState(current => {
      if (current === 'dark') return 'light'
      if (current === 'light') return 'system'
      return 'dark'
    })
  }

  return { theme, resolved, setTheme, cycleTheme }
}
