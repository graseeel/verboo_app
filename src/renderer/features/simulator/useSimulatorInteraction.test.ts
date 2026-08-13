import { describe, expect, it } from 'vitest'
import { simulatorKeyForKeyboardEvent } from './useSimulatorInteraction'

describe('simulator keyboard ownership', () => {
  it('maps only the supported special keys', () => {
    expect(simulatorKeyForKeyboardEvent({ key: 'Backspace' })).toBe('backspace')
    expect(simulatorKeyForKeyboardEvent({ key: 'Enter' })).toBe('enter')
    expect(simulatorKeyForKeyboardEvent({ key: 'ArrowUp' })).toBe('arrowUp')
    expect(simulatorKeyForKeyboardEvent({ key: 'Escape' })).toBeNull()
    expect(simulatorKeyForKeyboardEvent({ key: 'a' })).toBeNull()
  })
})
