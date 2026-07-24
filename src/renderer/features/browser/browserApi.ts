import { invoke } from '@tauri-apps/api/core'
import type { BrowserBounds } from './browserBounds'
import type { BrowserSessionSnapshot } from './browserTabs'

export const browserApi = {
  openSession: (bounds: BrowserBounds) =>
    invoke<BrowserSessionSnapshot>('browser_session_open', { bounds }),
  snapshot: () =>
    invoke<BrowserSessionSnapshot>('browser_session_snapshot'),
  setVisible: (visible: boolean) =>
    invoke<BrowserSessionSnapshot>('browser_session_set_visible', { visible }),
  destroy: () =>
    invoke<void>('browser_session_destroy'),
  createTab: (url?: string) =>
    invoke<BrowserSessionSnapshot>('browser_tab_create', { url }),
  activateTab: (tabId: string) =>
    invoke<BrowserSessionSnapshot>('browser_tab_activate', { tabId }),
  closeTab: (tabId: string) =>
    invoke<BrowserSessionSnapshot>('browser_tab_close', { tabId }),
  navigateTab: (tabId: string, url: string) =>
    invoke<BrowserSessionSnapshot>('browser_tab_navigate', { tabId, url }),
  back: (tabId: string) =>
    invoke<void>('browser_tab_back', { tabId }),
  forward: (tabId: string) =>
    invoke<void>('browser_tab_forward', { tabId }),
  reload: (tabId: string) =>
    invoke<void>('browser_tab_reload', { tabId }),
}
