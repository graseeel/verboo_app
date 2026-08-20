import { describe, expect, it } from 'vitest'
import { androidEmulatorKeyForKeyboardEvent, simulatorKeyForKeyboardEvent } from './useSimulatorInteraction'

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
