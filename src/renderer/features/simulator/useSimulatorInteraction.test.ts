import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { androidEmulatorKeyForKeyboardEvent, simulatorKeyForKeyboardEvent, useSimulatorInteraction } from './useSimulatorInteraction'

describe('simulator keyboard ownership', () => {
  it('maps only the supported special keys', () => {
    expect(simulatorKeyForKeyboardEvent({ key: 'Backspace' })).toBe('backspace')
    expect(simulatorKeyForKeyboardEvent({ key: 'Enter' })).toBe('enter')
    expect(simulatorKeyForKeyboardEvent({ key: 'ArrowUp' })).toBe('arrowUp')
    expect(simulatorKeyForKeyboardEvent({ key: 'Escape' })).toBeNull()
    expect(simulatorKeyForKeyboardEvent({ key: 'a' })).toBeNull()
  })
})

describe('android emulator keyboard mapping (PA-27 frozen key map)', () => {
  it('maps the frozen special keys to the android press_key vocabulary', () => {
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'Enter' })).toBe('enter')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'Backspace' })).toBe('backspace')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'Tab' })).toBe('tab')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'ArrowUp' })).toBe('arrowUp')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'ArrowDown' })).toBe('arrowDown')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'ArrowLeft' })).toBe('arrowLeft')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'ArrowRight' })).toBe('arrowRight')
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'Escape' })).toBe('escape')
    expect(androidEmulatorKeyForKeyboardEvent({ key: ' ' })).toBe('space')
  })

  it('leaves ordinary characters on the type_text path', () => {
    expect(androidEmulatorKeyForKeyboardEvent({ key: 'a' })).toBeNull()
  })
})

describe('useSimulatorInteraction — mediaSize injetada (canvas Android)', () => {
  it('maps taps through injected mediaSize without any image element', () => {
    const onTap = vi.fn()
    const surface = document.createElement('div')
    surface.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 300, height: 600 }) as DOMRect
    const { result } = renderHook(() => useSimulatorInteraction({
      surfaceRef: { current: surface },
      imageRef: { current: null },
      mode: 'interact',
      interactive: true,
      onTap,
      onDrag: vi.fn(),
      onTypeText: vi.fn(),
      onPressKey: vi.fn(),
      mediaSize: { width: 720, height: 1600 },
    }))
    const click = {
      button: 0,
      clientX: 150,
      clientY: 300,
      preventDefault: () => {},
      currentTarget: surface,
      nativeEvent: { isComposing: false },
    } as unknown as React.MouseEvent<HTMLDivElement>
    result.current.onClick(click)
    expect(onTap).toHaveBeenCalledWith({ x: 0.5, y: 0.5 })
  })
})
