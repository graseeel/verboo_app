import { useCallback, useMemo, useRef, useState } from 'react'
import { activeBrowserTab, emptyBrowserSession, MAX_LIVE_BROWSER_TABS } from './browserTabs'
import type { BrowserSessionSnapshot, BrowserTabSnapshot } from './browserTabs'
import { browserApi } from './browserApi'

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
  tabId: string
  generation: number
}

export type BrowserNavigationRequest = {
  id: string
  url: string
}

export function useBrowserPanel() {
  const [browserOpen, setBrowserOpen] = useState(false)
  const [browserWidth, setBrowserWidth] = useState(readWidth)
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('idle')
  const [reloadRequest, setReloadRequest] = useState<BrowserReloadRequest | undefined>()
  const [navigationRequest, setNavigationRequest] = useState<BrowserNavigationRequest | undefined>()
  const [session, setSession] = useState<BrowserSessionSnapshot>(emptyBrowserSession)
  const navigationSequenceRef = useRef(0)
  const browserOpenRef = useRef(false)
  const sessionRef = useRef<BrowserSessionSnapshot>(emptyBrowserSession)
  const tabUseSequenceRef = useRef(0)
  const tabLastUsedRef = useRef(new Map<string, number>())

  const activeTab: BrowserTabSnapshot | undefined = useMemo(
    () => activeBrowserTab(session),
    [session],
  )
  const currentUrl = activeTab && activeTab.url !== 'about:blank' ? activeTab.url : ''

  const registerSessionTabs = useCallback((next: BrowserSessionSnapshot) => {
    const currentIds = new Set(next.tabs.map(tab => tab.id))
    for (const tabId of tabLastUsedRef.current.keys()) {
      if (!currentIds.has(tabId)) tabLastUsedRef.current.delete(tabId)
    }
    for (const tab of next.tabs) {
      if (!tabLastUsedRef.current.has(tab.id)) {
        tabUseSequenceRef.current += 1
        tabLastUsedRef.current.set(tab.id, tabUseSequenceRef.current)
      }
    }
  }, [])

  const markTabUsed = useCallback((tabId: string) => {
    tabUseSequenceRef.current += 1
    tabLastUsedRef.current.set(tabId, tabUseSequenceRef.current)
  }, [])

  const applySession = useCallback((next: BrowserSessionSnapshot) => {
    registerSessionTabs(next)
    sessionRef.current = next
    setSession(next)
  }, [registerSessionTabs])

  const enforceLiveTabLimit = useCallback(async (snapshot: BrowserSessionSnapshot) => {
    const liveTabs = snapshot.tabs.filter(tab => !tab.evicted)
    if (liveTabs.length <= MAX_LIVE_BROWSER_TABS) return snapshot

    const victim = liveTabs
      .filter(tab => tab.id !== snapshot.activeTabId)
      .reduce<BrowserTabSnapshot | undefined>((oldest, tab) => {
        if (!oldest) return tab
        const tabUse = tabLastUsedRef.current.get(tab.id) ?? 0
        const oldestUse = tabLastUsedRef.current.get(oldest.id) ?? 0
        return tabUse < oldestUse ? tab : oldest
      }, undefined)
    if (!victim) return snapshot

    const limited = await browserApi.evictTab(victim.id)
    applySession(limited)
    return limited
  }, [applySession])

  const open = useCallback(() => {
    const wasOpen = browserOpenRef.current
    browserOpenRef.current = true
    setBrowserOpen(true)
    if (!wasOpen) {
      // Rust owns the post-unsuspend silence guarantee. The renderer only
      // returns media control when the retained panel becomes visible again.
      for (const tab of sessionRef.current.tabs.filter(tab => !tab.evicted)) {
        void browserApi.setMediaSuspended(tab.id, false).catch(() => {})
      }
    }
  }, [])

  const close = useCallback(() => {
    const wasOpen = browserOpenRef.current
    browserOpenRef.current = false
    setBrowserOpen(false)
    setAnnotationMode('idle')
    if (wasOpen) {
      // Inactive native webviews are hidden, not suspended, so any tab may still
      // be playing. Minimize must pause every retained tab, not only the active one.
      for (const tab of sessionRef.current.tabs.filter(tab => !tab.evicted)) {
        void browserApi.setMediaSuspended(tab.id, true).catch(() => {})
      }
    }
  }, [])

  const toggle = useCallback(() => {
    if (browserOpenRef.current) close()
    else open()
  }, [close, open])

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
    open()
    setNavigationRequest(current => {
      if (current?.url === url) return current
      navigationSequenceRef.current += 1
      return { id: `auto-preview:${navigationSequenceRef.current}`, url }
    })
  }, [open])

  const completeNavigation = useCallback((id: string) => {
    setNavigationRequest(current => current?.id === id ? undefined : current)
  }, [])

  const createTab = useCallback((url?: string) => {
    return browserApi.createTab(url).then(async snapshot => {
      applySession(snapshot)
      return enforceLiveTabLimit(snapshot)
    })
  }, [applySession, enforceLiveTabLimit])

  const activateTab = useCallback((tabId: string) => {
    const tab = sessionRef.current.tabs.find(current => current.id === tabId)
    const activation = tab?.evicted
      ? browserApi.reactivateTab(tabId)
      : browserApi.activateTab(tabId)
    return activation.then(async snapshot => {
      markTabUsed(tabId)
      applySession(snapshot)
      if (tab?.evicted) await enforceLiveTabLimit(snapshot)
    })
  }, [applySession, enforceLiveTabLimit, markTabUsed])

  const navigateTab = useCallback((tabId: string, url: string) => {
    return browserApi.navigateTab(tabId, url).then(snapshot => {
      markTabUsed(tabId)
      applySession(snapshot)
      return snapshot
    })
  }, [applySession, markTabUsed])

  const closeTab = useCallback((tabId: string) => {
    void browserApi.closeTab(tabId).then(applySession).catch(() => {})
  }, [applySession])

  return {
    browserOpen, browserWidth, annotationMode, currentUrl, reloadRequest, navigationRequest,
    session, activeTab, applySession,
    open, close, toggle, setWidth, togglePencil, toggleArrow,
    requestReload, completeReload, requestNavigation, completeNavigation,
    createTab, activateTab, navigateTab, closeTab,
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
