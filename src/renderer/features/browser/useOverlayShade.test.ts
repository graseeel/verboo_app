import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { invoke } from '@tauri-apps/api/core'
import { useOverlayShade, createOverlayShadeEntry, _resetOverlayShadeForTests } from './useOverlayShade'

// Mock invoke for browser_snapshot + convertFileSrc
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({
    ms: 12,
    bytes: 1024,
    path: '/tmp/snapshot.png',
    dataUrl: 'data:image/png;base64,c25hcHNob3Q=',
  }),
}))

describe('useOverlayShade', () => {
  beforeEach(() => {
    _resetOverlayShadeForTests()
    vi.clearAllMocks()
  })

  it('starts not shading', () => {
    const { result } = renderHook(() => useOverlayShade(false))
    expect(result.current.isShading).toBe(false)
    expect(result.current.snapshotDataUrl).toBeNull()
  })

  it('registers and unregisters overlays', () => {
    const { result } = renderHook(() => useOverlayShade(false))

    let release: () => void
    act(() => {
      release = result.current.register(true)
    })
    expect(result.current.isShading).toBe(true)

    act(() => { release() })
    expect(result.current.isShading).toBe(false)
  })

  it('multiple overlays — shading stays until all released', () => {
    const { result } = renderHook(() => useOverlayShade(false))

    let release1: () => void
    let release2: () => void

    act(() => {
      release1 = result.current.register(true)
    })
    act(() => {
      release2 = result.current.register(true)
    })

    expect(result.current.isShading).toBe(true)

    act(() => { release1!() })
    expect(result.current.isShading).toBe(true)

    act(() => { release2!() })
    expect(result.current.isShading).toBe(false)
  })

  it('non-shading overlay does not trigger shading', () => {
    const { result } = renderHook(() => useOverlayShade(false))

    act(() => {
      result.current.register(false)
    })

    expect(result.current.isShading).toBe(false)
  })

  it('captures before hiding and restores the live webview after release', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useOverlayShade(true, true, 'tab-a', 1))

    let release: () => void
    act(() => {
      release = result.current.register(true)
    })

    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('browser_snapshot', { tabId: 'tab-a', generation: 1 })
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    const calls = vi.mocked(invoke).mock.calls.map(([command]) => command)
    expect(calls.indexOf('browser_snapshot')).toBeLessThan(calls.indexOf('browser_session_set_visible'))

    act(() => release!())
    expect(result.current.isShading).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: true })

    act(() => { vi.advanceTimersByTime(140) })
    expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true })
    expect(result.current.isShading).toBe(false)
    vi.useRealTimers()
  })

  it('does not hide after a fast-close snapshot race', async () => {
    let resolveSnapshot: ((value: unknown) => void) | undefined
    vi.mocked(invoke).mockImplementationOnce(() => new Promise(resolve => { resolveSnapshot = resolve }))
    const { result, unmount } = renderHook(() => useOverlayShade(true, true, 'tab-a', 1))

    let release: () => void
    act(() => { release = result.current.register(true) })
    act(() => { release!() })
    await act(async () => {
      resolveSnapshot!({
        ms: 12,
        bytes: 1024,
        path: '/tmp/snapshot.png',
        dataUrl: 'data:image/png;base64,c25hcHNob3Q=',
      })
      await Promise.resolve()
    })

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_snapshot', { tabId: 'tab-a', generation: 1 }))
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
    expect(invoke).toHaveBeenCalledWith('browser_delete_temp_files', { paths: ['/tmp/snapshot.png'] })
    unmount()
  })

  it('automatically shades modal dialogs added anywhere in renderer DOM', async () => {
    const { result } = renderHook(() => useOverlayShade(true, true))
    const modal = document.createElement('section')
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')

    act(() => { document.body.appendChild(modal) })
    await waitFor(() => expect(result.current.isShading).toBe(true))

    act(() => { modal.remove() })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('browser_session_set_visible', { visible: true }))
  })

  it('skips the snapshot when there is no active tab', () => {
    const { result } = renderHook(() => useOverlayShade(true, true))

    act(() => { result.current.register(true) })

    expect(invoke).not.toHaveBeenCalledWith('browser_snapshot', expect.anything())
    expect(invoke).not.toHaveBeenCalledWith('browser_session_set_visible', { visible: false })
  })
})

describe('createOverlayShadeEntry', () => {
  it('creates and releases an entry', () => {
    const entry = createOverlayShadeEntry(true)
    expect(entry.id).toBeTruthy()
    entry.release() // should not throw
  })
})
