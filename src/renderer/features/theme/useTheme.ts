import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import type { ThemeMode } from '../../../shared/types'

const THEME_KEY = 'verboo:theme'

function readTheme(): ThemeMode {
  return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark'
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeMode>(readTheme)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  return { theme, setTheme } satisfies { theme: ThemeMode; setTheme: Dispatch<SetStateAction<ThemeMode>> }
}
