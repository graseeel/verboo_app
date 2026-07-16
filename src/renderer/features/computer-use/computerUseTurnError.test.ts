import { describe, expect, it } from 'vitest'
import { computerUseTurnStartMessage } from './computerUseTurnError'

describe('computerUseTurnStartMessage', () => {
  it('preserves a concrete Computer Use admission error', () => {
    expect(computerUseTurnStartMessage(
      new Error('Computer Use turn does not match the authorized session.'),
      'Computer Use could not start.',
    )).toBe('Computer Use turn does not match the authorized session.')
  })

  it('uses the localized fallback when the error has no message', () => {
    expect(computerUseTurnStartMessage(
      new Error(''),
      'Computer Use could not start.',
    )).toBe('Computer Use could not start.')
  })
})
