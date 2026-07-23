import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useBrowserPanel } from './useBrowserPanel'

describe('useBrowserPanel — annotation mode', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('starts in idle mode', () => {
    const { result } = renderHook(() => useBrowserPanel())
    expect(result.current.annotationMode).toBe('idle')
  })

  it('toggles pencil mode', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.togglePencil())
    expect(result.current.annotationMode).toBe('pencil')
    act(() => result.current.togglePencil())
    expect(result.current.annotationMode).toBe('idle')
  })

  it('toggles arrow mode', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.toggleArrow())
    expect(result.current.annotationMode).toBe('arrow')
    act(() => result.current.toggleArrow())
    expect(result.current.annotationMode).toBe('idle')
  })

  it('pencil and arrow are mutually exclusive', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.togglePencil())
    expect(result.current.annotationMode).toBe('pencil')
    act(() => result.current.toggleArrow())
    expect(result.current.annotationMode).toBe('arrow')
    act(() => result.current.togglePencil())
    expect(result.current.annotationMode).toBe('pencil')
  })

  it('close resets annotation mode', () => {
    const { result } = renderHook(() => useBrowserPanel())
    act(() => result.current.open())
    act(() => result.current.togglePencil())
    expect(result.current.annotationMode).toBe('pencil')
    act(() => result.current.close())
    expect(result.current.annotationMode).toBe('idle')
    expect(result.current.browserOpen).toBe(false)
  })
})
