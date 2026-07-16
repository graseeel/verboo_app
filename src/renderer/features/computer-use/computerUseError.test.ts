import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportComputerUseError } from './computerUseError'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reportComputerUseError', () => {
  it('returns only controlled UI copy and logs the raw failure for diagnostics', () => {
    const rawError = new Error('provider secret: internal-path')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(reportComputerUseError(
      'list running apps',
      rawError,
      'Could not list running apps.',
    )).toBe('Could not list running apps.')
    expect(consoleError).toHaveBeenCalledWith(
      '[computer-use] list running apps',
      rawError,
    )
  })
})
