import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { UpdateChannel, UpdateSnapshot } from '../../../shared/types'
import { useUpdateAutomation } from './useUpdateAutomation'

const snapshot = (status: UpdateSnapshot['status']): UpdateSnapshot => ({
  status,
  channel: 'stable',
  currentVersion: '0.5.2',
  availableVersion: ['available', 'downloading', 'downloaded'].includes(status)
    ? '0.6.0'
    : undefined,
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useUpdateAutomation', () => {
  it('checks immediately and again after six hours while enabled', async () => {
    vi.useFakeTimers()
    const check = vi.fn().mockResolvedValue(snapshot('idle'))

    renderHook(() => useUpdateAutomation({
      autoCheck: true,
      autoDownload: false,
      channel: 'stable',
      snapshot: snapshot('idle'),
      check,
      download: vi.fn(),
    }))

    expect(check).toHaveBeenCalledTimes(1)
    await act(() => vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000))
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('stages an available version once without requesting install', async () => {
    const download = vi.fn().mockResolvedValue(snapshot('downloaded'))
    const view = renderHook(() => useUpdateAutomation({
      autoCheck: false,
      autoDownload: true,
      channel: 'beta',
      snapshot: { ...snapshot('available'), channel: 'beta' },
      check: vi.fn(),
      download,
    }))

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1))
    expect(download).toHaveBeenCalledWith(false)
    view.rerender()
    expect(download).toHaveBeenCalledTimes(1)
  })

  it('never silently downloads a CLI-only update', () => {
    const download = vi.fn()
    renderHook(() => useUpdateAutomation({
      autoCheck: false,
      autoDownload: true,
      channel: 'beta',
      snapshot: {
        ...snapshot('available'),
        channel: 'beta',
        target: 'cli',
        availableVersion: undefined,
        cliAvailableVersion: '0.15.6',
      },
      check: vi.fn(),
      download,
    }))

    expect(download).not.toHaveBeenCalled()
  })

  it('does not check while disabled and checks again after a channel change', () => {
    const check = vi.fn().mockResolvedValue(snapshot('idle'))
    type AutomationProps = { autoCheck: boolean; channel: UpdateChannel }
    const view = renderHook(
      ({ autoCheck, channel }: AutomationProps) => useUpdateAutomation({
        autoCheck,
        autoDownload: false,
        channel,
        snapshot: snapshot('idle'),
        check,
        download: vi.fn(),
      }),
      { initialProps: { autoCheck: false, channel: 'stable' } as AutomationProps },
    )

    expect(check).not.toHaveBeenCalled()
    act(() => view.rerender({ autoCheck: true, channel: 'stable' }))
    expect(check).toHaveBeenCalledTimes(1)
    act(() => view.rerender({ autoCheck: true, channel: 'beta' }))
    expect(check).toHaveBeenCalledTimes(2)
  })
})
