import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBrowserPanel } from './useBrowserPanel'

describe('useBrowserPanel', () => {
  beforeEach(() => {
    window.localStorage.clear()
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

  it('restores width from localStorage', () => {
    // Store a value within valid range (MIN_WIDTH=520 .. 60% of window)
    window.localStorage.setItem('verboo:browser-width', '580')
    const { result } = renderHook(() => useBrowserPanel())
    expect(result.current.browserWidth).toBe(580)
  })
})
