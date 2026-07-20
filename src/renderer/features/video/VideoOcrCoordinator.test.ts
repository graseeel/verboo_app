import { describe, expect, it, vi } from 'vitest'

import { createVideoOcrCoordinator } from './VideoOcrCoordinator'
import type { VideoOcrRequest } from '../../../shared/types'

function request(jobId: string, count: number): VideoOcrRequest {
  return {
    jobId,
    frames: Array.from({ length: count }, (_, index) => ({
      timestampMs: index * 1000,
      url: `asset://frames/frame-${index}.png`,
    })),
  }
}

describe('VideoOcrCoordinator', () => {
  it('processes frames serially and retains timestamps', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const recognize = vi.fn(async (url: string) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return { text: `text for ${url}`, confidence: 90 }
    })
    const complete = vi.fn(async (_jobId: string, _results: import('../../../shared/types').VideoOcrText[]) => {})
    const coordinator = createVideoOcrCoordinator({ recognize, complete })

    await coordinator.handleRequest(request('job-1', 4))

    expect(maxInFlight).toBe(1)
    expect(complete).toHaveBeenCalledTimes(1)
    const [jobId, results] = complete.mock.calls[0]
    expect(jobId).toBe('job-1')
    expect(results.map((item: { timestampMs: number }) => item.timestampMs)).toEqual([
      0, 1000, 2000, 3000,
    ])
  })

  it('skips individual failures and empty results without failing the batch', async () => {
    const recognize = vi
      .fn()
      .mockResolvedValueOnce({ text: 'first', confidence: 80 })
      .mockRejectedValueOnce(new Error('worker crashed'))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ text: '   ', confidence: 10 })
      .mockResolvedValueOnce({ text: 'last', confidence: 70 })
    const complete = vi.fn(async (_jobId: string, _results: import('../../../shared/types').VideoOcrText[]) => {})
    const coordinator = createVideoOcrCoordinator({ recognize, complete })

    await coordinator.handleRequest(request('job-2', 5))

    expect(complete).toHaveBeenCalledTimes(1)
    const [, results] = complete.mock.calls[0]
    expect(results.map((item: { text: string }) => item.text)).toEqual(['first', 'last'])
  })

  it('an all-error batch still completes with an empty result set', async () => {
    const recognize = vi.fn().mockRejectedValue(new Error('no worker'))
    const complete = vi.fn(async (_jobId: string, _results: import('../../../shared/types').VideoOcrText[]) => {})
    const coordinator = createVideoOcrCoordinator({ recognize, complete })

    await coordinator.handleRequest(request('job-3', 3))

    expect(complete).toHaveBeenCalledWith('job-3', [])
  })

  it('completes the backend exactly once per job', async () => {
    const recognize = vi.fn(async () => ({ text: 'x', confidence: 50 }))
    const complete = vi.fn(async (_jobId: string, _results: import('../../../shared/types').VideoOcrText[]) => {})
    const coordinator = createVideoOcrCoordinator({ recognize, complete })
    const batch = request('job-4', 1)

    await coordinator.handleRequest(batch)
    await coordinator.handleRequest(batch)

    expect(complete).toHaveBeenCalledTimes(1)
  })

  it('cancellation stops remaining frames but still returns partial results', async () => {
    const complete = vi.fn(async (_jobId: string, _results: import('../../../shared/types').VideoOcrText[]) => {})
    let coordinator: ReturnType<typeof createVideoOcrCoordinator> | null = null
    const recognize = vi.fn(async (url: string) => {
      if (url.includes('frame-1')) coordinator?.cancel('job-5')
      return { text: url, confidence: 60 }
    })
    coordinator = createVideoOcrCoordinator({ recognize, complete })

    await coordinator.handleRequest(request('job-5', 5))

    expect(recognize).toHaveBeenCalledTimes(2)
    const [, results] = complete.mock.calls[0]
    expect(results).toHaveLength(2)
  })

  it('a backend completion failure is swallowed (waiter already released)', async () => {
    const recognize = vi.fn(async () => ({ text: 'x', confidence: 50 }))
    const complete = vi.fn(async () => {
      throw new Error('no pending OCR batch for this job')
    })
    const coordinator = createVideoOcrCoordinator({ recognize, complete })

    await expect(coordinator.handleRequest(request('job-6', 1))).resolves.toBeUndefined()
  })
})
