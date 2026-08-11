import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WhatsNewAcknowledgeResult } from '../../../shared/types'
import { useWhatsNew } from './useWhatsNew'

const pending = { version: '0.7.0-beta', tag: 'v0.7.0-beta', preview: false }

describe('useWhatsNew', () => {
  it('does not query before startup is ready and queries once after readiness', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => ({ persisted: true }))
    const { result, rerender } = renderHook(
      ({ enabled }) => useWhatsNew({ enabled, getStatus, acknowledge }),
      { initialProps: { enabled: false } },
    )
    expect(getStatus).not.toHaveBeenCalled()
    rerender({ enabled: true })
    await waitFor(() => expect(result.current.status).toEqual(pending))
    expect(getStatus).toHaveBeenCalledTimes(1)
  })

  it('dismisses for the process even when persistence reports a non-fatal error', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => ({ persisted: false, error: 'disk unavailable' }))
    const { result } = renderHook(() => useWhatsNew({ enabled: true, getStatus, acknowledge }))
    await waitFor(() => expect(result.current.status).toEqual(pending))
    let response: WhatsNewAcknowledgeResult | undefined
    await act(async () => { response = await result.current.acknowledge('0.7.0-beta') })
    expect(response).toEqual({ persisted: false, error: 'disk unavailable' })
    expect(result.current.status).toBeUndefined()
  })

  it('dismisses for the process even when the bridge rejects unexpectedly', async () => {
    const getStatus = vi.fn(async () => pending)
    const acknowledge = vi.fn(async () => { throw new Error('IPC unavailable') })
    const { result } = renderHook(() => useWhatsNew({ enabled: true, getStatus, acknowledge }))
    await waitFor(() => expect(result.current.status).toEqual(pending))
    await act(async () => {
      await expect(result.current.acknowledge('0.7.0-beta')).rejects.toThrow('IPC unavailable')
    })
    expect(result.current.status).toBeUndefined()
  })
})
