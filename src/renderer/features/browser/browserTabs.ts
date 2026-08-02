export type BrowserTabSnapshot = {
  id: string
  label: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  generation: number
  recoverableError: string | null
  evicted: boolean
}

export type BrowserSessionSnapshot = {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  visible: boolean
}

// Mirrors Rust browser_panel::MAX_LIVE_TABS. The source contract is pinned by
// browserTabs.test.ts so the renderer cannot silently drift from the native cap.
export const MAX_LIVE_BROWSER_TABS = 8

export const emptyBrowserSession: BrowserSessionSnapshot = {
  tabs: [],
  activeTabId: null,
  visible: false,
}

export function activeBrowserTab(session: BrowserSessionSnapshot): BrowserTabSnapshot | undefined {
  return session.tabs.find(tab => tab.id === session.activeTabId)
}
