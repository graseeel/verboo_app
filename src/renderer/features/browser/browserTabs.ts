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
}

export type BrowserSessionSnapshot = {
  tabs: BrowserTabSnapshot[]
  activeTabId: string | null
  visible: boolean
}

export const emptyBrowserSession: BrowserSessionSnapshot = {
  tabs: [],
  activeTabId: null,
  visible: false,
}

export function activeBrowserTab(session: BrowserSessionSnapshot): BrowserTabSnapshot | undefined {
  return session.tabs.find(tab => tab.id === session.activeTabId)
}
