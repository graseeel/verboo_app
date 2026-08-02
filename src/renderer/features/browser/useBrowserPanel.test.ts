import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { browserLayoutWidth, useBrowserPanel } from './useBrowserPanel'
import type { BrowserSessionSnapshot } from './browserTabs'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

function browserTab(id: string, evicted = false) {
  return {
    id, label: `label-${id}`, url: `https://${id}.example`, title: `Title ${id}`,
    canGoBack: false, canGoForward: false, loading: false,
    generation: 0, recoverableError: null, evicted,
  }
}

function browserSession(ids: string[], activeTabId: string, evictedIds: string[] = []): BrowserSessionSnapshot {
  return {
    tabs: ids.map(id => browserTab(id, evictedIds.includes(id))),
    activeTabId,
    visible: true,
  }
}

async function runLruScenario(recentlyUsedTabId?: string) {
  const ids = ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e', 'tab-f', 'tab-g', 'tab-h']
  const initial = browserSession(ids, 'tab-h')
  const afterActivation = browserSession(ids, recentlyUsedTabId ?? 'tab-h')
  const overLimit = browserSession([...ids, 'tab-new'], 'tab-new')
  vi.mocked(invoke).mockImplementation((command, payload) => {
    if (command === 'browser_tab_activate') return Promise.resolve(afterActivation)
    if (command === 'browser_tab_create') return Promise.resolve(overLimit)
    if (command === 'browser_tab_evict') {
      const tabId = (payload as { tabId: string }).tabId
      return Promise.resolve(browserSession([...ids, 'tab-new'], 'tab-new', [tabId]))
    }
    return Promise.resolve(undefined)
  })
  const hook = renderHook(() => useBrowserPanel())
  act(() => hook.result.current.applySession(initial))
  if (recentlyUsedTabId) {
    await act(async () => { await hook.result.current.activateTab(recentlyUsedTabId) })
  }
  await act(async () => { await hook.result.current.createTab() })
  return hook
}

describe('useBrowserPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    vi.mocked(invoke).mockResolvedValue(undefined)
  })

  it('starts closed with default width', () => {
    const { result } = renderHook(() => useBrowserPanel())
    expect(result.current.browserOpen).toBe(false)
    // Default width is 680, may be clamped to 60% of jsdom window
    expect(result.current.browserWidth).toBeGreaterThanOrEqual(520)
    expect(result.current.browserWidth).toBeLessThanOrEqual(864)
  })

  it('opens and closes', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.open())
    expect(result.current.browserOpen).toBe(true)
    act(() => result.current.close())
    expect(result.current.browserOpen).toBe(false)
  })

  it('toggles', () => {
    const { result } = renderHook(() => useBrowserPanel())
    expect(result.current.browserOpen).toBe(false)
    act(() => result.current.toggle())
    expect(result.current.browserOpen).toBe(true)
    act(() => result.current.toggle())
    expect(result.current.browserOpen).toBe(false)
  })

  it('persists width to localStorage', () => {
    const { result } = renderHook(() => useBrowserPanel())
    // Use a value within the jsdom window's 60% limit
    act(() => result.current.setWidth(560))
    expect(window.localStorage.getItem('verboo:browser-width')).toBe('560')
    expect(result.current.browserWidth).toBe(560)
  })

  it('clamps width to MIN_WIDTH', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.setWidth(300))
    expect(result.current.browserWidth).toBe(520)
  })

  it('clamps width to 60% of window', () => {
    const { result } = renderHook(() => useBrowserPanel())
    const maxWindow = Math.floor(window.innerWidth * 0.6)
    act(() => result.current.setWidth(99999))
    expect(result.current.browserWidth).toBe(maxWindow)
  })

  it('reserves usable chat space when the fixed sidebar is visible', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1224 })
    const { result } = renderHook(() => useBrowserPanel())

    act(() => result.current.setWidth(99999, 384))

    expect(result.current.browserWidth).toBe(520)
  })

  it('clamps the rendered width immediately when reserved space changes', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1224 })

    expect(browserLayoutWidth(734, 384)).toBe(520)
  })

  it('restores width from localStorage', () => {
    // Store a value within valid range (MIN_WIDTH=520 .. 60% of window)
    window.localStorage.setItem('verboo:browser-width', '580')
    const { result } = renderHook(() => useBrowserPanel())
    expect(result.current.browserWidth).toBe(580)
  })

  it('derives the live URL from the active tab and tracks one post-edit reload request', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.applySession({
      tabs: [{ id: 'tab-a', label: 'label-a', url: 'http://localhost:5173', title: '', canGoBack: false,
        canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false }],
      activeTabId: 'tab-a',
      visible: true,
    }))
    act(() => result.current.requestReload({
      id: 'turn-1', conversationId: 'chat-1', autoVerify: true,
      url: 'http://localhost:5173',
      targetRect: { x: 1, y: 2, width: 3, height: 4 },
      verificationPrompt: 'verify',
      tabId: 'tab-a',
      generation: 0,
    }))

    expect(result.current.currentUrl).toBe('http://localhost:5173')
    expect(result.current.reloadRequest?.id).toBe('turn-1')
    act(() => result.current.completeReload('turn-1'))
    expect(result.current.reloadRequest).toBeUndefined()
  })

  it('tracks one automatic local navigation request until the panel handles it', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.requestNavigation('http://127.0.0.1:8765/'))

    expect(result.current.navigationRequest?.url).toBe('http://127.0.0.1:8765/')
    act(() => result.current.completeNavigation(result.current.navigationRequest!.id))
    expect(result.current.navigationRequest).toBeUndefined()
  })

  it('hides and reopens without discarding the last native snapshot', () => {
    const { result } = renderHook(() => useBrowserPanel())
    const session: BrowserSessionSnapshot = {
      tabs: [{ id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false,
        canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false }],
      activeTabId: 'tab-a',
      visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(session)
    act(() => result.current.applySession(session))
    act(() => result.current.open())
    act(() => result.current.close())
    act(() => result.current.open())
    expect(result.current.session).toEqual(session)
    expect(result.current.browserOpen).toBe(true)
  })

  it('minimizes by suspending every tab and reopens by returning media control', () => {
    const { result } = renderHook(() => useBrowserPanel())
    const session: BrowserSessionSnapshot = {
      tabs: [
        { id: 'tab-a', label: 'label-a', url: 'https://example.com', title: 'Example', canGoBack: false,
          canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false },
        { id: 'tab-b', label: 'label-b', url: 'https://music.example', title: 'Music', canGoBack: false,
          canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false },
      ],
      activeTabId: 'tab-a',
      visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(session)
    act(() => result.current.applySession(session))
    act(() => result.current.open())
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-a', suspended: false })
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-b', suspended: false })
    vi.mocked(invoke).mockClear()

    act(() => result.current.close())

    expect(result.current.browserOpen).toBe(false)
    expect(result.current.session).toEqual(session)
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-a', suspended: true })
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-b', suspended: true })
    expect(invoke).not.toHaveBeenCalledWith(
      'browser_tab_set_media_suspended',
      expect.objectContaining({ suspended: false }),
    )
    vi.mocked(invoke).mockClear()

    act(() => result.current.open())

    expect(result.current.browserOpen).toBe(true)
    expect(result.current.session).toEqual(session)
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-a', suspended: false })
    expect(invoke).toHaveBeenCalledWith('browser_tab_set_media_suspended', { tabId: 'tab-b', suspended: false })
    expect(invoke).not.toHaveBeenCalledWith(
      'browser_tab_set_media_suspended',
      expect.objectContaining({ suspended: true }),
    )
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'browser_tab_set_media_suspended')).toHaveLength(2)
  })

  it('derives the active tab from the applied session', () => {
    const { result } = renderHook(() => useBrowserPanel())
    const session: BrowserSessionSnapshot = {
      tabs: [
        { id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false,
          canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false },
        { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: 'Example',
          canGoBack: true, canGoForward: false, loading: true, generation: 3, recoverableError: null, evicted: false },
      ],
      activeTabId: 'tab-b',
      visible: true,
    }
    act(() => result.current.applySession(session))
    expect(result.current.activeTab?.id).toBe('tab-b')
    expect(result.current.activeTab?.url).toBe('https://example.com')
  })

  it('keeps the open panel available when a snapshot with zero tabs is applied', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.open())
    act(() => result.current.applySession({ tabs: [], activeTabId: null, visible: false }))
    expect(result.current.browserOpen).toBe(true)
    expect(result.current.activeTab).toBeUndefined()
  })

  it('createTab calls browser_tab_create and applies the returned snapshot', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabs: [{ id: 'tab-new', label: 'label-new', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false }],
      activeTabId: 'tab-new', visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(snapshot)
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.createTab() })

    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
    expect(result.current.session).toEqual(snapshot)
    expect(result.current.activeTab?.id).toBe('tab-new')
  })

  it('createTab forwards an optional url to browser_tab_create', async () => {
    vi.mocked(invoke).mockResolvedValue({ tabs: [], activeTabId: null, visible: false })
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.createTab('https://example.com') })

    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: 'https://example.com' })
  })

  it('activateTab calls browser_tab_activate with tabId and applies the snapshot', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabs: [
        { id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false },
        { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false },
      ],
      activeTabId: 'tab-b', visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(snapshot)
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.activateTab('tab-b') })

    expect(invoke).toHaveBeenCalledWith('browser_tab_activate', { tabId: 'tab-b' })
    expect(result.current.activeTab?.id).toBe('tab-b')
  })

  it('closeTab calls browser_tab_close with tabId and applies the snapshot', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabs: [{ id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null, evicted: false }],
      activeTabId: 'tab-a', visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(snapshot)
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.closeTab('tab-b') })

    expect(invoke).toHaveBeenCalledWith('browser_tab_close', { tabId: 'tab-b' })
    expect(result.current.session).toEqual(snapshot)
  })

  it('createTab returns errors to the panel instead of swallowing them silently', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('backend down'))
    const { result } = renderHook(() => useBrowserPanel())

    await expect(result.current.createTab()).rejects.toThrow('backend down')

    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
    // The failed snapshot never mutates the session; BrowserPanel owns the
    // visible recovery state because it has the translated UI.
    expect(result.current.session.tabs).toHaveLength(0)
  })

  it('evicts the least recently used live tab after creation and never evicts the active tab', async () => {
    const { result } = await runLruScenario()

    expect(invoke).toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-a' })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-new' })
    expect(result.current.activeTab?.id).toBe('tab-new')
    expect(result.current.session.tabs.find(tab => tab.id === 'tab-a')?.evicted).toBe(true)
  })

  it('keeps the same LRU policy but evicts the next tab after the oldest one is used', async () => {
    const { result } = await runLruScenario('tab-a')

    expect(invoke).toHaveBeenCalledWith('browser_tab_activate', { tabId: 'tab-a' })
    expect(invoke).toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-b' })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-a' })
    expect(result.current.session.tabs.find(tab => tab.id === 'tab-b')?.evicted).toBe(true)
  })

  it('never evicts the active tab even when it has the oldest recorded use', async () => {
    const ids = ['tab-a', 'tab-b', 'tab-c', 'tab-d', 'tab-e', 'tab-f', 'tab-g', 'tab-h']
    const initial = browserSession(ids, 'tab-h')
    const overLimit = browserSession([...ids, 'tab-new'], 'tab-a')
    vi.mocked(invoke).mockImplementation((command, payload) => {
      if (command === 'browser_tab_create') return Promise.resolve(overLimit)
      if (command === 'browser_tab_evict') {
        const tabId = (payload as { tabId: string }).tabId
        return Promise.resolve(browserSession([...ids, 'tab-new'], 'tab-a', [tabId]))
      }
      return Promise.resolve(undefined)
    })
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.applySession(initial))

    await act(async () => { await result.current.createTab() })

    expect(invoke).toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-b' })
    expect(invoke).not.toHaveBeenCalledWith('browser_tab_evict', { tabId: 'tab-a' })
    expect(result.current.activeTab?.id).toBe('tab-a')
  })
})
