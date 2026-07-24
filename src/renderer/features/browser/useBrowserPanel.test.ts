import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { browserLayoutWidth, useBrowserPanel } from './useBrowserPanel'
import type { BrowserSessionSnapshot } from './browserTabs'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

describe('useBrowserPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
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

  it('tracks the live URL and one post-edit reload request', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.setCurrentUrl('http://localhost:5173'))
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
        canGoForward: false, loading: false, generation: 0, recoverableError: null }],
      activeTabId: 'tab-a',
      visible: true,
    }
    act(() => result.current.applySession(session))
    act(() => result.current.open())
    act(() => result.current.close())
    act(() => result.current.open())
    expect(result.current.session).toEqual(session)
    expect(result.current.browserOpen).toBe(true)
  })

  it('derives the active tab from the applied session', () => {
    const { result } = renderHook(() => useBrowserPanel())
    const session: BrowserSessionSnapshot = {
      tabs: [
        { id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false,
          canGoForward: false, loading: false, generation: 0, recoverableError: null },
        { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: 'Example',
          canGoBack: true, canGoForward: false, loading: true, generation: 3, recoverableError: null },
      ],
      activeTabId: 'tab-b',
      visible: true,
    }
    act(() => result.current.applySession(session))
    expect(result.current.activeTab?.id).toBe('tab-b')
    expect(result.current.activeTab?.url).toBe('https://example.com')
  })

  it('closes the panel when a snapshot with zero tabs is applied', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.open())
    act(() => result.current.applySession({ tabs: [], activeTabId: null, visible: false }))
    expect(result.current.browserOpen).toBe(false)
    expect(result.current.activeTab).toBeUndefined()
  })

  it('createTab calls browser_tab_create and applies the returned snapshot', async () => {
    const snapshot: BrowserSessionSnapshot = {
      tabs: [{ id: 'tab-new', label: 'label-new', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null }],
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
        { id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null },
        { id: 'tab-b', label: 'label-b', url: 'https://example.com', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null },
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
      tabs: [{ id: 'tab-a', label: 'label-a', url: 'about:blank', title: '', canGoBack: false, canGoForward: false, loading: false, generation: 0, recoverableError: null }],
      activeTabId: 'tab-a', visible: true,
    }
    vi.mocked(invoke).mockResolvedValue(snapshot)
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.closeTab('tab-b') })

    expect(invoke).toHaveBeenCalledWith('browser_tab_close', { tabId: 'tab-b' })
    expect(result.current.session).toEqual(snapshot)
  })

  it('createTab swallows errors silently without crashing the hook', async () => {
    vi.mocked(invoke).mockRejectedValue(new Error('backend down'))
    const { result } = renderHook(() => useBrowserPanel())

    await act(async () => { await result.current.createTab() })

    expect(invoke).toHaveBeenCalledWith('browser_tab_create', { url: undefined })
    // session stays at empty default, no throw
    expect(result.current.session.tabs).toHaveLength(0)
  })
})
