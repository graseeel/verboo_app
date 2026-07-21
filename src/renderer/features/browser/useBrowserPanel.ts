import { useCallback, useState } from 'react'

const BROWSER_WIDTH_KEY = 'verboo:browser-width'
const DEFAULT_WIDTH = 680
const MIN_WIDTH = 520

export type AnnotationMode = 'idle' | 'pencil' | 'arrow'

export function useBrowserPanel() {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(readWidth)
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('idle')

  const open = useCallback(() => {
    setBrowserOpen(true)
  }, [])

  const close = useCallback(() => {
    setBrowserOpen(false)
    setAnnotationMode('idle')
  }, [])

  const toggle = useCallback(() => {
    setBrowserOpen(current => !current)
  }, [])

  const setWidth = useCallback((nextWidth: number) => {
    const maxWindow = Math.floor(window.innerWidth * 0.6)
    const width = Math.max(MIN_WIDTH, Math.min(maxWindow, nextWidth))
    setBrowserWidth(width)
    try {
      window.localStorage.setItem(BROWSER_WIDTH_KEY, String(width))
    } catch {
      // Width persistence is optional.
    }
  }, [])

  const togglePencil = useCallback(() => {
    setAnnotationMode(current => current === 'pencil' ? 'idle' : 'pencil')
  }, [])

  const toggleArrow = useCallback(() => {
    setAnnotationMode(current => current === 'arrow' ? 'idle' : 'arrow')
  }, [])

  return {
    browserOpen, browserWidth, annotationMode,
    open, close, toggle, setWidth, togglePencil, toggleArrow,
    MIN_WIDTH,
  }
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(BROWSER_WIDTH_KEY))
    if (!Number.isFinite(stored)) return DEFAULT_WIDTH
    const maxWindow = typeof window !== 'undefined'
      ? Math.floor(window.innerWidth * 0.6)
      : DEFAULT_WIDTH
    return Math.max(MIN_WIDTH, Math.min(maxWindow, stored))
  } catch {
    return DEFAULT_WIDTH
  }
}
