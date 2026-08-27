import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS,
  retryValidateAccessUntilUnlocked,
} from './completeCliLogin'

describe('retryValidateAccessUntilUnlocked', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('unlocks on the second attempt after 500ms', async () => {
    const validate = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)

    const pending = retryValidateAccessUntilUnlocked(validate)
    await vi.advanceTimersByTimeAsync(0)
    expect(validate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS[0] - 1)
    expect(validate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)
    await expect(pending).resolves.toBe(true)
    expect(validate).toHaveBeenCalledTimes(2)
  })

  it('gives up after the initial check plus two delayed retries', async () => {
    const validate = vi.fn().mockResolvedValue(false)

    const pending = retryValidateAccessUntilUnlocked(validate)
    await vi.advanceTimersByTimeAsync(0)
    expect(validate).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS[0])
    expect(validate).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(CLI_LOGIN_UNLOCK_RETRY_DELAYS_MS[1])
    await expect(pending).resolves.toBe(false)
    expect(validate).toHaveBeenCalledTimes(3)
  })
})
