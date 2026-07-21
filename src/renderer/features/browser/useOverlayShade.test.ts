import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useOverlayShade, createOverlayShadeEntry, _resetOverlayShadeForTests } from './useOverlayShade'

// Mock invoke for browser_snapshot + convertFileSrc
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ ms: 12, bytes: 1024, path: '/tmp/snapshot.png' }),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}))

describe('useOverlayShade', () => {
  beforeEach(() => {
    _resetOverlayShadeForTests()
  })

  it('starts not shading', () => {
    const { result } = renderHook(() => useOverlayShade(false))
    expect(result.current.isShading).toBe(false)
    expect(result.current.snapshotDataUrl).toBeNull()
  })

  it('registers and unregisters overlays', () => {
    const { result } = renderHook(() => useOverlayShade(true))

    let release: () => void
    act(() => {
      release = result.current.register(true)
    })
    expect(result.current.isShading).toBe(true)

    act(() => { release() })
    expect(result.current.isShading).toBe(false)
  })

  it('multiple overlays — shading stays until all released', () => {
    const { result } = renderHook(() => useOverlayShade(true))

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
    const { result } = renderHook(() => useOverlayShade(true))

    act(() => {
      result.current.register(false)
    })

    expect(result.current.isShading).toBe(false)
  })
})

describe('createOverlayShadeEntry', () => {
  it('creates and releases an entry', () => {
    const entry = createOverlayShadeEntry(true)
    expect(entry.id).toBeTruthy()
    entry.release() // should not throw
  })
})
