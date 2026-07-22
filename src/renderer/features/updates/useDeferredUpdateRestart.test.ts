import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { UpdateSnapshot } from '../../../shared/types'
import { useDeferredUpdateRestart } from './useDeferredUpdateRestart'

const snapshot = (status: UpdateSnapshot['status']): UpdateSnapshot => ({
  status,
  channel: 'beta',
  currentVersion: '0.5.2',
  availableVersion: ['available', 'downloading', 'downloaded'].includes(status)
    ? '0.6.0'
    : undefined,
})

function setup(
  overrides: Partial<Parameters<typeof useDeferredUpdateRestart>[0]> = {},
) {
  const options: Parameters<typeof useDeferredUpdateRestart>[0] = {
    runningCount: 0,
    snapshot: snapshot('available'),
    check: vi.fn().mockResolvedValue(snapshot('available')),
    download: vi.fn().mockResolvedValue(snapshot('downloaded')),
    install: vi.fn().mockResolvedValue({ status: 'restarting', activeTurns: 0 }),
    persistDrafts: vi.fn(),
    clearDrafts: vi.fn(),
    ...overrides,
  }
  return renderHook(() => useDeferredUpdateRestart(options))
}

describe('useDeferredUpdateRestart', () => {
  it('waits for every running chat without interrupting', async () => {
    const download = vi.fn().mockResolvedValue(snapshot('downloaded'))
    const install = vi
      .fn()
      .mockResolvedValue({ status: 'restarting', activeTurns: 0 })
    const persistDrafts = vi.fn()
    const test = renderHook(
      ({ runningCount, current }) =>
        useDeferredUpdateRestart({
          runningCount,
          snapshot: current,
          check: vi.fn(),
          download,
          install,
          persistDrafts,
          clearDrafts: vi.fn(),
        }),
      {
        initialProps: {
          runningCount: 2,
          current: snapshot('available'),
        },
      },
    )

    await act(async () => test.result.current.requestUpdate())
    act(() =>
      test.rerender({ runningCount: 2, current: snapshot('downloaded') }),
    )
    expect(test.result.current.presentation?.phase).toBe('waiting')
    expect(install).not.toHaveBeenCalled()

    act(() =>
      test.rerender({ runningCount: 0, current: snapshot('downloaded') }),
    )
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1))
    expect(persistDrafts).toHaveBeenCalledTimes(1)
  })

  it('shows ready after auto-download and does not restart before a click', () => {
    const install = vi.fn()
    const test = setup({ snapshot: snapshot('downloaded'), install })

    expect(test.result.current.presentation?.phase).toBe('ready')
    expect(install).not.toHaveBeenCalled()
  })

  it('retries only after a backend-busy turn appears and finishes', async () => {
    const install = vi
      .fn()
      .mockResolvedValueOnce({ status: 'busy', activeTurns: 1 })
      .mockResolvedValueOnce({ status: 'restarting', activeTurns: 0 })
    const test = renderHook(
      ({ runningCount }) =>
        useDeferredUpdateRestart({
          runningCount,
          snapshot: snapshot('downloaded'),
          check: vi.fn(),
          download: vi.fn(),
          install,
          persistDrafts: vi.fn(),
          clearDrafts: vi.fn(),
        }),
      { initialProps: { runningCount: 0 } },
    )

    await act(async () => test.result.current.requestUpdate())
    await waitFor(() =>
      expect(test.result.current.presentation?.phase).toBe('waiting'),
    )
    expect(install).toHaveBeenCalledTimes(1)

    act(() => test.rerender({ runningCount: 1 }))
    act(() => test.rerender({ runningCount: 0 }))
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  })

  it('clears the handoff and exposes retry on install failure', async () => {
    const clearDrafts = vi.fn()
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error('restart failed'))
      .mockResolvedValueOnce({ status: 'restarting', activeTurns: 0 })
    const test = setup({
      snapshot: snapshot('downloaded'),
      install,
      clearDrafts,
    })

    await act(async () => test.result.current.requestUpdate())
    await waitFor(() =>
      expect(test.result.current.presentation?.phase).toBe('error'),
    )
    expect(clearDrafts).toHaveBeenCalledTimes(1)

    await act(async () => test.result.current.requestUpdate())
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2))
  })

  it('surfaces check failures instead of attempting a restart', async () => {
    const install = vi.fn()
    const test = setup({
      snapshot: snapshot('error'),
      check: vi.fn().mockRejectedValue(new Error('offline')),
      install,
    })

    await act(async () => test.result.current.requestUpdate())
    await waitFor(() =>
      expect(test.result.current.presentation).toMatchObject({
        phase: 'error',
        error: 'offline',
        actionEnabled: true,
      }),
    )
    expect(install).not.toHaveBeenCalled()
  })
})
