import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { browserApi } from './browserApi'
import type { BrowserBounds } from './browserBounds'
import type { BrowserSessionSnapshot } from './browserTabs'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ tabs: [], activeTabId: null, visible: false }),
}))

const sampleSnapshot: BrowserSessionSnapshot = {
  tabs: [{
    id: 'tab-a', label: 'label-a', url: 'about:blank', title: '',
    canGoBack: false, canGoForward: false, loading: false,
    generation: 0, recoverableError: null, evicted: false,
  }],
  activeTabId: 'tab-a',
  visible: true,
}

const bounds: BrowserBounds = { x: 10, y: 20, width: 680, height: 600 }

describe('browserApi', () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear()
    vi.mocked(invoke).mockResolvedValue(sampleSnapshot)
  })

  it('creates, activates, evicts, reactivates, and closes tabs through tab-addressed commands', async () => {
    await browserApi.createTab()
    await browserApi.activateTab('tab-a')
    await browserApi.evictTab('tab-a')
    await browserApi.reactivateTab('tab-a')
    await browserApi.closeTab('tab-a')
    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
    expect(invoke).toHaveBeenCalledWith('browser_tab_activate', { tabId: 'tab-a' })
    expect(invoke).toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-a' })
    expect(invoke).toHaveBeenCalledWith('browser_tab_reactivate', { tabId: 'tab-a' })
    expect(invoke).toHaveBeenCalledWith('browser_tab_close', { tabId: 'tab-a' })
  })

  it('opens the session with measured bounds and reads the snapshot', async () => {
    await browserApi.openSession(bounds)
    await browserApi.snapshot()
    expect(invoke).toHaveBeenCalledWith('browser_session_open', { bounds })
    expect(invoke).toHaveBeenCalledWith('browser_session_snapshot')
  })

  it('toggles visibility without discarding the session', async () => {
    await browserApi.setVisible(false)
    await browserApi.setVisible(true)
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
  })

  it('sets media suspension for one tab through the camelCase Tauri boundary', async () => {
    await browserApi.setMediaSuspended('tab-a', true)

    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', {
      tabId: 'tab-a',
      suspended: true,
    })
  })

  it('pins browser command names and fields against the Rust source', () => {
    const rustSource = readFileSync(
      resolve(__dirname, '../../../../src-tauri/src/services/browser_panel.rs'),
      'utf8',
    )
    const rustRegistration = readFileSync(
      resolve(__dirname, '../../../../src-tauri/src/lib.rs'),
      'utf8',
    )

    // Cross-component contract rule: the foreign source is the authority. A
    // renderer-only copy would stay green if Rust renamed this command or a field.
    expect(rustSource).toMatch(
      /pub async fn browser_tab_set_media_suspended\s*\(\s*state: State<'_, BrowserPanelState>,\s*tab_id: BrowserTabId,\s*suspended: bool,\s*\)/,
    )
    expect(rustSource).toMatch(
      /pub async fn browser_tab_evict\s*\(\s*state: State<'_, BrowserPanelState>,\s*tab_id: BrowserTabId,\s*\)/,
    )
    expect(rustSource).toMatch(
      /pub fn browser_tab_reactivate\s*\(\s*app: AppHandle,\s*state: State<'_, BrowserPanelState>,\s*tab_id: BrowserTabId,\s*\)/,
    )
    expect(rustRegistration).toContain('browser_panel::browser_tab_set_media_suspended')
    expect(rustRegistration).toContain('browser_panel::browser_tab_evict')
    expect(rustRegistration).toContain('browser_panel::browser_tab_reactivate')
  })

  it('returns the native session snapshot typed by each command', async () => {
    const result = await browserApi.activateTab('tab-a')
    expect(result).toEqual(sampleSnapshot)
  })

  it('forwards an optional url to createTab and omits it when absent', async () => {
    await browserApi.createTab('https://example.com')
    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: 'https://example.com' })
    await browserApi.createTab()
    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
  })
})
