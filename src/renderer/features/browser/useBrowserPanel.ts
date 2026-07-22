import { useCallback, useRef, useState } from 'react'

const BROWSER_WIDTH_KEY = 'verboo:browser-width'
const DEFAULT_WIDTH = 680
const MIN_WIDTH = 520
const MIN_WORKSPACE_WIDTH = 320

export type AnnotationMode = 'idle' | 'pencil' | 'arrow'
export type BrowserReloadRequest = {
  id: string
  conversationId: string
  url: string
  targetRect: { x: number; y: number; width: number; height: number }
  autoVerify: boolean
  verificationPrompt: string
}

export type BrowserNavigationRequest = {
  id: string
  url: string
}

export function useBrowserPanel() {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(readWidth)
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('idle')
  const [currentUrl, setCurrentUrl] = useState('')
  const [reloadRequest, setReloadRequest] = useState<BrowserReloadRequest | undefined>()
  const [navigationRequest, setNavigationRequest] = useState<BrowserNavigationRequest | undefined>()
  const navigationSequenceRef = useRef(0)

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

  const setWidth = useCallback((nextWidth: number, reservedWidth = 0) => {
    const maxWindow = browserMaxWidth(reservedWidth)
    const minWindow = Math.min(MIN_WIDTH, maxWindow)
    const width = Math.max(minWindow, Math.min(maxWindow, nextWidth))
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

  const requestReload = useCallback((request: BrowserReloadRequest) => {
    setReloadRequest(request)
  }, [])

  const completeReload = useCallback((id: string) => {
    setReloadRequest(current => current?.id === id ? undefined : current)
  }, [])

  const requestNavigation = useCallback((url: string) => {
    setBrowserOpen(true)
    setNavigationRequest(current => {
      if (current?.url === url) return current
      navigationSequenceRef.current += 1
      return { id: `auto-preview:${navigationSequenceRef.current}`, url }
    })
  }, [])

  const completeNavigation = useCallback((id: string) => {
    setNavigationRequest(current => current?.id === id ? undefined : current)
  }, [])

  return {
    browserOpen, browserWidth, annotationMode, currentUrl, reloadRequest, navigationRequest,
    open, close, toggle, setWidth, togglePencil, toggleArrow,
    setCurrentUrl, requestReload, completeReload, requestNavigation, completeNavigation,
    MIN_WIDTH,
  }
}

function readWidth(): number {
  try {
    const stored = Number(window.localStorage.getItem(BROWSER_WIDTH_KEY))
    if (!Number.isFinite(stored)) return DEFAULT_WIDTH
    const maxWindow = browserMaxWidth()
    const minWindow = Math.min(MIN_WIDTH, maxWindow)
    return Math.max(minWindow, Math.min(maxWindow, stored))
  } catch {
    return DEFAULT_WIDTH
  }
}

export function browserMaxWidth(reservedWidth = 0): number {
  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : DEFAULT_WIDTH / 0.6
  return Math.max(0, Math.floor(Math.min(
    viewportWidth * 0.6,
    viewportWidth - Math.max(0, reservedWidth) - MIN_WORKSPACE_WIDTH,
  )))
}

export function browserLayoutWidth(browserWidth: number, reservedWidth = 0): number {
  return Math.max(0, Math.min(browserWidth, browserMaxWidth(reservedWidth)))
}
