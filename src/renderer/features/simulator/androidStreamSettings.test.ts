import { describe, expect, it, vi } from 'vitest'
import {
  loadPersistedStreamFps,
  persistStreamFps,
  resolveStoredStreamFps,
} from './androidStreamSettings'

describe('android stream settings', () => {
  it('normalizes persisted values to the supported stream rates', () => {
    expect(resolveStoredStreamFps(30)).toBe(30)
    expect(resolveStoredStreamFps(60)).toBe(60)
    expect(resolveStoredStreamFps(undefined)).toBe(60)
    expect(resolveStoredStreamFps(99)).toBe(60)
  })

  it('falls back to 60 fps when loading settings fails', async () => {
    const bridge = {
      getUserSettings: vi.fn().mockRejectedValue(new Error('settings unavailable')),
      updateUserSettings: vi.fn(),
    }

    await expect(loadPersistedStreamFps(bridge)).resolves.toBe(60)
  })

  it('reports whether persistence succeeded', async () => {
    const bridge = {
      getUserSettings: vi.fn(),
      updateUserSettings: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('write failed')),
    }

    await expect(persistStreamFps(bridge, 30)).resolves.toBe(true)
    await expect(persistStreamFps(bridge, 60)).resolves.toBe(false)
  })
})
